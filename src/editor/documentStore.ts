import { invoke } from '@tauri-apps/api/core'
import { normalizeWorkspaceRelativePath } from '../layout/workspaceContentModel'
import { choiceDialog } from '../components/appDialogStore'

export type TextDocumentEncoding = 'utf8' | 'utf8Bom'
export type TextDocumentLineEnding = 'lf' | 'crlf'

export type TextDocumentRevision = {
  sha256: string
  size: number
  modifiedAtNs: string
}

export type NativeTextDocument = {
  content: string
  revision: TextDocumentRevision
  encoding: TextDocumentEncoding
  lineEnding: TextDocumentLineEnding
}

export type NativeSaveTextDocumentResult =
  | { status: 'saved'; document: NativeTextDocument }
  | { status: 'conflict'; currentRevision: TextDocumentRevision | null }

export type EditorTextModel = {
  getValue(): string
  setValue(value: string): void
  onDidChangeContent(listener: () => void): { dispose(): void }
  dispose(): void
}

export type EditorDocumentConflict = {
  currentRevision: TextDocumentRevision | null
  diskContent: string | null
  diskEncoding: TextDocumentEncoding | null
  diskLineEnding: TextDocumentLineEnding | null
}

export type EditorDocument = {
  relPath: string
  original: string
  current: string
  revision: TextDocumentRevision | null
  encoding: TextDocumentEncoding
  lineEnding: TextDocumentLineEnding
  dirty: boolean
  loading: boolean
  saving: boolean
  conflict: EditorDocumentConflict | null
  errors: string[]
  viewCount: number
  model: EditorTextModel | null
}

export type EditorCloseDecision = 'save' | 'discard' | 'cancel'
export type EditorCloseResult = 'closed' | 'cancelled'
export type EditorCloseDecider = (document: EditorDocument) => EditorCloseDecision | Promise<EditorCloseDecision>

export type EditorSaveAllResult = {
  saved: string[]
  failed: Array<{ relPath: string; reason: string }>
}

export type EditorDocumentRefreshHooks = {
  afterSave?: (relPath: string) => void | Promise<void>
}

type DocumentRecord = EditorDocument & {
  modelSubscription: { dispose(): void } | null
  modelSyncing: boolean
}

const workspaceStores = new Map<string, EditorDocumentStore>()
const MAX_RETAINED_DOCUMENTS = 24

export class EditorDocumentStore {
  readonly sessionId: string
  readonly workspaceFolder: string

  private documents = new Map<string, DocumentRecord>()
  private listeners = new Set<() => void>()
  private loads = new Map<string, Promise<EditorDocument>>()
  private lastAccessed = new Map<string, number>()
  private lastAccessTime = 0
  private refreshHooks: EditorDocumentRefreshHooks = {}

  constructor(sessionId: string, workspaceFolder: string) {
    this.sessionId = sessionId
    this.workspaceFolder = workspaceFolder
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  setRefreshHooks(hooks: EditorDocumentRefreshHooks): void {
    this.refreshHooks = hooks
  }

  getDocument(relPath: string): EditorDocument | null {
    const normalized = requireNormalizedPath(relPath)
    const document = this.documents.get(normalized) ?? null
    if (document) this.touch(normalized)
    return document
  }

  listDocuments(): EditorDocument[] {
    return [...this.documents.values()]
  }

  documentsUnder(relPath: string): EditorDocument[] {
    const normalized = requireNormalizedPath(relPath)
    return [...this.documents.values()].filter((document) => document.relPath === normalized || document.relPath.startsWith(`${normalized}/`))
  }

  retain(relPath: string): EditorDocument {
    const normalized = requireNormalizedPath(relPath)
    const current = this.documents.get(normalized) ?? emptyDocument(normalized)
    const next = { ...current, viewCount: current.viewCount + 1 }
    this.documents.set(normalized, next)
    this.touch(normalized)
    this.evictRetainedDocuments()
    this.emit()
    return next
  }

  release(relPath: string): void {
    const normalized = requireNormalizedPath(relPath)
    const current = this.documents.get(normalized)
    if (!current) return
    this.documents.set(normalized, { ...current, viewCount: Math.max(0, current.viewCount - 1) })
    this.touch(normalized)
    // Dirty documents and live views intentionally survive panel unmounts. Clean,
    // closed documents remain cached only while they fit within the LRU bound.
    this.evictRetainedDocuments()
    this.emit()
  }

  async load(relPath: string): Promise<EditorDocument> {
    const normalized = requireNormalizedPath(relPath)
    const existing = this.documents.get(normalized)
    if (existing && !existing.loading && existing.revision) {
      this.touch(normalized)
      return existing
    }
    const pending = this.loads.get(normalized)
    if (pending) {
      this.touch(normalized)
      return pending
    }

    this.update(normalized, (document) => ({ ...document, loading: true, errors: [] }))
    const request = invoke<NativeTextDocument>('fs_open_text_document', {
      workspaceFolder: this.workspaceFolder,
      relPath: normalized,
    }).then((opened) => {
      const latest = this.documents.get(normalized) ?? emptyDocument(normalized)
      const next = this.record({
        ...latest,
        original: opened.content,
        current: latest.revision ? latest.current : opened.content,
        revision: opened.revision,
        encoding: opened.encoding,
        lineEnding: opened.lineEnding,
        dirty: latest.revision ? latest.current !== opened.content : false,
        loading: false,
        conflict: null,
        errors: [],
      })
      this.documents.set(normalized, next)
      this.touch(normalized)
      this.syncModelValue(next)
      this.evictRetainedDocuments()
      this.emit()
      return next
    }).catch((reason) => {
      const message = errorMessage(reason)
      const next = this.update(normalized, (document) => ({ ...document, loading: false, errors: [message] }))
      this.evictRetainedDocuments()
      throw new Error(next.errors[0])
    }).finally(() => this.loads.delete(normalized))
    this.loads.set(normalized, request)
    return request
  }

  updateCurrent(relPath: string, current: string): void {
    const normalized = requireNormalizedPath(relPath)
    this.update(normalized, (document) => ({
      ...document,
      current,
      dirty: current !== document.original,
      errors: [],
    }))
    this.evictRetainedDocuments()
  }

  attachModel(relPath: string, model: EditorTextModel): EditorTextModel {
    const normalized = requireNormalizedPath(relPath)
    const current = this.documents.get(normalized) ?? emptyDocument(normalized)
    this.touch(normalized)
    if (current.model && current.model !== model) {
      model.dispose()
      return current.model
    }
    if (current.model === model) return model
    if (model.getValue() !== current.current) model.setValue(current.current)
    const next = this.record({ ...current, model })
    next.modelSubscription = model.onDidChangeContent(() => {
      const latest = this.documents.get(normalized)
      if (!latest || latest.modelSyncing) return
      this.updateCurrent(normalized, model.getValue())
    })
    this.documents.set(normalized, next)
    this.evictRetainedDocuments()
    this.emit()
    return model
  }

  async save(relPath: string): Promise<NativeSaveTextDocumentResult> {
    const normalized = requireNormalizedPath(relPath)
    const document = await this.load(normalized)
    if (!document.revision) throw new Error('Document has no revision and cannot be saved in place.')
    if (document.saving) throw new Error('Document is already saving.')
    const content = document.current
    this.update(normalized, (latest) => ({ ...latest, saving: true, errors: [] }))
    try {
      const result = await invoke<NativeSaveTextDocumentResult>('fs_save_text_document', {
        workspaceFolder: this.workspaceFolder,
        relPath: normalized,
        content,
        expectedRevision: document.revision,
        encoding: document.encoding,
        lineEnding: document.lineEnding,
      })
      if (result.status === 'conflict') {
        this.update(normalized, (latest) => ({
          ...latest,
          saving: false,
          conflict: {
            currentRevision: result.currentRevision,
            diskContent: null,
            diskEncoding: null,
            diskLineEnding: null,
          },
          errors: ['The file changed on disk. Review the conflict before saving again.'],
        }))
        await this.refreshConflict(normalized).catch(() => undefined)
        return result
      }
      const savedContent = result.document.content
      const next = this.update(normalized, (latest) => {
        const current = latest.current === content ? savedContent : latest.current
        return {
          ...latest,
          original: savedContent,
          current,
          revision: result.document.revision,
          encoding: result.document.encoding,
          lineEnding: result.document.lineEnding,
          dirty: current !== savedContent,
          saving: false,
          conflict: null,
          errors: [],
        }
      })
      this.syncModelValue(next)
      await this.runAfterSave(normalized)
      this.evictRetainedDocuments()
      return result
    } catch (reason) {
      const message = errorMessage(reason)
      this.update(normalized, (latest) => ({ ...latest, saving: false, errors: [message] }))
      throw reason
    }
  }

  async checkRevision(relPath: string): Promise<void> {
    const normalized = requireNormalizedPath(relPath)
    const document = this.documents.get(normalized)
    if (!document?.revision || document.loading || document.saving) return
    let currentRevision: TextDocumentRevision
    try {
      currentRevision = await invoke<TextDocumentRevision>('fs_text_document_revision', {
        workspaceFolder: this.workspaceFolder,
        relPath: normalized,
      })
    } catch (reason) {
      if (document.dirty) {
        this.update(normalized, (latest) => ({
          ...latest,
          conflict: { currentRevision: null, diskContent: null, diskEncoding: null, diskLineEnding: null },
          errors: [`The file is no longer readable on disk: ${errorMessage(reason)}`],
        }))
      }
      return
    }
    if (sameRevision(document.revision, currentRevision)) return
    if (document.dirty) {
      this.update(normalized, (latest) => ({
        ...latest,
        conflict: { currentRevision, diskContent: null, diskEncoding: null, diskLineEnding: null },
        errors: ['The file changed on disk. Review the conflict before saving again.'],
      }))
      await this.refreshConflict(normalized).catch(() => undefined)
      return
    }
    let opened: NativeTextDocument
    try {
      opened = await invoke<NativeTextDocument>('fs_open_text_document', {
        workspaceFolder: this.workspaceFolder,
        relPath: normalized,
      })
    } catch (reason) {
      this.update(normalized, (latest) => ({ ...latest, errors: [errorMessage(reason)] }))
      return
    }
    const next = this.update(normalized, (latest) => ({
      ...latest,
      original: opened.content,
      current: opened.content,
      revision: opened.revision,
      encoding: opened.encoding,
      lineEnding: opened.lineEnding,
      dirty: false,
      conflict: null,
      errors: [],
    }))
    this.syncModelValue(next)
    this.evictRetainedDocuments()
  }

  async saveAs(relPath: string, targetRelPath: string): Promise<NativeSaveTextDocumentResult> {
    const normalized = requireNormalizedPath(relPath)
    const target = requireNormalizedPath(targetRelPath)
    if (target === normalized) return this.save(normalized)
    const source = await this.load(normalized)
    const targetDocument = this.documents.get(target)
    if (targetDocument?.dirty) throw new Error(`Cannot replace ${target}; it has unsaved local changes.`)
    this.update(normalized, (latest) => ({ ...latest, saving: true, errors: [] }))
    try {
      const result = await invoke<NativeSaveTextDocumentResult>('fs_save_text_document_as', {
        workspaceFolder: this.workspaceFolder,
        relPath: target,
        content: source.current,
        expectedRevision: null,
        encoding: source.encoding,
        lineEnding: source.lineEnding,
      })
      this.update(normalized, (latest) => ({ ...latest, saving: false }))
      if (result.status === 'conflict') {
        this.update(normalized, (latest) => ({ ...latest, errors: [`Save As did not overwrite ${target} because it already exists or changed.`] }))
        return result
      }
      const existing = this.documents.get(target) ?? emptyDocument(target)
      const saved = this.record({
        ...existing,
        original: result.document.content,
        current: result.document.content,
        revision: result.document.revision,
        encoding: result.document.encoding,
        lineEnding: result.document.lineEnding,
        dirty: false,
        loading: false,
        saving: false,
        conflict: null,
        errors: [],
      })
      this.documents.set(target, saved)
      this.touch(target)
      this.syncModelValue(saved)
      await this.runAfterSave(target)
      this.evictRetainedDocuments()
      this.emit()
      return result
    } catch (reason) {
      const message = errorMessage(reason)
      this.update(normalized, (latest) => ({ ...latest, saving: false, errors: [message] }))
      throw reason
    }
  }

  async refreshConflict(relPath: string): Promise<EditorDocumentConflict> {
    const normalized = requireNormalizedPath(relPath)
    let opened: NativeTextDocument
    try {
      opened = await invoke<NativeTextDocument>('fs_open_text_document', {
        workspaceFolder: this.workspaceFolder,
        relPath: normalized,
      })
    } catch (reason) {
      this.update(normalized, (document) => ({ ...document, errors: [`Could not reload the disk version: ${errorMessage(reason)}`] }))
      throw reason
    }
    const conflict = {
      currentRevision: opened.revision,
      diskContent: opened.content,
      diskEncoding: opened.encoding,
      diskLineEnding: opened.lineEnding,
    } satisfies EditorDocumentConflict
    this.update(normalized, (document) => ({ ...document, conflict, errors: [] }))
    return conflict
  }

  async discardLocal(relPath: string): Promise<void> {
    const normalized = requireNormalizedPath(relPath)
    let opened: NativeTextDocument
    try {
      opened = await invoke<NativeTextDocument>('fs_open_text_document', {
        workspaceFolder: this.workspaceFolder,
        relPath: normalized,
      })
    } catch (reason) {
      this.update(normalized, (document) => ({ ...document, errors: [errorMessage(reason)] }))
      throw reason
    }
    const next = this.update(normalized, (document) => ({
      ...document,
      original: opened.content,
      current: opened.content,
      revision: opened.revision,
      encoding: opened.encoding,
      lineEnding: opened.lineEnding,
      dirty: false,
      conflict: null,
      errors: [],
    }))
    this.syncModelValue(next)
    this.evictRetainedDocuments()
  }

  async requestClose(relPath: string, decide: EditorCloseDecider = browserEditorCloseDecision): Promise<EditorCloseResult> {
    const normalized = requireNormalizedPath(relPath)
    const document = this.documents.get(normalized)
    if (!document?.dirty) return 'closed'
    const decision = await decide(document)
    if (decision === 'cancel') return 'cancelled'
    if (decision === 'discard') {
      if (document.conflict) {
        try {
          await this.discardLocal(normalized)
          return 'closed'
        } catch {
          return 'cancelled'
        }
      }
      this.update(normalized, (latest) => ({ ...latest, current: latest.original, dirty: false, conflict: null, errors: [] }))
      const latest = this.documents.get(normalized)
      if (latest) this.syncModelValue(latest)
      this.evictRetainedDocuments()
      return 'closed'
    }
    try {
      const result = await this.save(normalized)
      return result.status === 'saved' && !this.documents.get(normalized)?.dirty ? 'closed' : 'cancelled'
    } catch {
      return 'cancelled'
    }
  }

  async preparePathMutation(relPath: string, decide: EditorCloseDecider = browserEditorCloseDecision): Promise<EditorCloseResult> {
    for (const document of this.documentsUnder(relPath).filter((candidate) => candidate.dirty)) {
      if (await this.requestClose(document.relPath, decide) === 'cancelled') return 'cancelled'
    }
    return 'closed'
  }

  async saveAll(): Promise<EditorSaveAllResult> {
    const result: EditorSaveAllResult = { saved: [], failed: [] }
    for (const document of this.listDocuments().filter((candidate) => candidate.dirty)) {
      try {
        const saved = await this.save(document.relPath)
        if (saved.status === 'saved') result.saved.push(document.relPath)
        else result.failed.push({ relPath: document.relPath, reason: 'conflict' })
      } catch (reason) {
        result.failed.push({ relPath: document.relPath, reason: errorMessage(reason) })
      }
    }
    return result
  }

  applyRename(fromRelPath: string, toRelPath: string): void {
    const from = requireNormalizedPath(fromRelPath)
    const to = requireNormalizedPath(toRelPath)
    const moving = [...this.documents.entries()].filter(([path]) => path === from || path.startsWith(`${from}/`))
    const targets = moving.map(([path]) => path === from ? to : `${to}${path.slice(from.length)}`)
    for (const target of targets) {
      if (this.documents.has(target) && !moving.some(([path]) => path === target)) throw new Error(`An editor document already exists for ${target}.`)
    }
    for (const [path] of moving) {
      this.documents.delete(path)
      this.lastAccessed.delete(path)
    }
    moving.forEach(([, document], index) => {
      document.modelSubscription?.dispose()
      document.model?.dispose()
      this.documents.set(targets[index], this.record({ ...document, relPath: targets[index], viewCount: 0, model: null }))
      this.touch(targets[index])
    })
    this.evictRetainedDocuments()
    this.emit()
  }

  applyDelete(relPath: string): void {
    const normalized = requireNormalizedPath(relPath)
    for (const [path, document] of this.documents) {
      if (path !== normalized && !path.startsWith(`${normalized}/`)) continue
      document.modelSubscription?.dispose()
      document.model?.dispose()
      this.documents.delete(path)
      this.lastAccessed.delete(path)
    }
    this.emit()
  }

  dispose(): void {
    for (const document of this.documents.values()) {
      document.modelSubscription?.dispose()
      document.model?.dispose()
    }
    this.documents.clear()
    this.lastAccessed.clear()
    this.loads.clear()
    this.listeners.clear()
  }

  private record(document: EditorDocument | DocumentRecord): DocumentRecord {
    return {
      ...document,
      modelSubscription: 'modelSubscription' in document ? document.modelSubscription : null,
      modelSyncing: 'modelSyncing' in document ? document.modelSyncing : false,
    }
  }

  private update(relPath: string, updater: (document: DocumentRecord) => EditorDocument | DocumentRecord): DocumentRecord {
    const current = this.documents.get(relPath) ?? emptyDocument(relPath)
    const next = this.record(updater(current))
    this.documents.set(relPath, next)
    this.touch(relPath)
    this.emit()
    return next
  }

  private syncModelValue(document: DocumentRecord): void {
    if (!document.model || document.model.getValue() === document.current) return
    document.modelSyncing = true
    try {
      document.model.setValue(document.current)
    } finally {
      document.modelSyncing = false
    }
  }

  private async runAfterSave(relPath: string): Promise<void> {
    try {
      await this.refreshHooks.afterSave?.(relPath)
    } catch (reason) {
      this.update(relPath, (document) => ({ ...document, errors: [`Saved, but refresh failed: ${errorMessage(reason)}`] }))
    }
  }

  private touch(relPath: string): void {
    this.lastAccessTime = Math.max(Date.now(), this.lastAccessTime + 1)
    this.lastAccessed.set(relPath, this.lastAccessTime)
  }

  private evictRetainedDocuments(): void {
    if (this.documents.size <= MAX_RETAINED_DOCUMENTS) return
    const candidates = [...this.documents.entries()]
      .filter(([, document]) => !document.dirty && document.viewCount === 0 && !document.loading && !document.saving)
      .sort(([left], [right]) => (this.lastAccessed.get(left) ?? 0) - (this.lastAccessed.get(right) ?? 0))
    for (const [relPath, document] of candidates) {
      if (this.documents.size <= MAX_RETAINED_DOCUMENTS) break
      document.modelSubscription?.dispose()
      document.model?.dispose()
      this.documents.delete(relPath)
      this.lastAccessed.delete(relPath)
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

export function getEditorDocumentStore(sessionId: string, workspaceFolder: string): EditorDocumentStore {
  const key = workspaceStoreKey(sessionId, workspaceFolder)
  // ponytail: a moved session cleans on next editor access; if never reopened,
  // its one stale store remains only until session-wide release.
  for (const [staleKey, staleStore] of workspaceStores) {
    if (staleStore.sessionId !== sessionId || staleKey === key) continue
    staleStore.dispose()
    workspaceStores.delete(staleKey)
  }
  let store = workspaceStores.get(key)
  if (!store) {
    store = new EditorDocumentStore(sessionId, workspaceFolder)
    workspaceStores.set(key, store)
  }
  return store
}

export function disposeEditorDocumentStore(sessionId: string): void {
  for (const [key, store] of workspaceStores) {
    if (store.sessionId !== sessionId) continue
    store.dispose()
    workspaceStores.delete(key)
  }
}

export async function requestEditorDocumentClose(
  sessionId: string,
  workspaceFolder: string,
  relPath: string,
  decide?: EditorCloseDecider,
): Promise<EditorCloseResult> {
  return getEditorDocumentStore(sessionId, workspaceFolder).requestClose(relPath, decide)
}

export async function saveAllEditorDocuments(sessionId: string, workspaceFolder: string): Promise<EditorSaveAllResult> {
  return getEditorDocumentStore(sessionId, workspaceFolder).saveAll()
}

/** Save / Discard / Cancel for one dirty document. The two-step native confirm
 *  chain this replaced could not express three outcomes in one dialog. */
export async function browserEditorCloseDecision(document: EditorDocument): Promise<EditorCloseDecision> {
  const choice = await choiceDialog({
    title: 'Unsaved changes',
    message: `${document.relPath} has unsaved changes.`,
    choices: [{ id: 'discard', label: 'Discard', tone: 'danger' }, { id: 'save', label: 'Save', tone: 'primary' }],
  })
  return choice === 'save' || choice === 'discard' ? choice : 'cancel'
}

function emptyDocument(relPath: string): DocumentRecord {
  return {
    relPath,
    original: '',
    current: '',
    revision: null,
    encoding: 'utf8',
    lineEnding: 'lf',
    dirty: false,
    loading: true,
    saving: false,
    conflict: null,
    errors: [],
    viewCount: 0,
    model: null,
    modelSubscription: null,
    modelSyncing: false,
  }
}

function requireNormalizedPath(relPath: string): string {
  const normalized = normalizeWorkspaceRelativePath(relPath)
  if (!normalized) throw new Error(`Invalid workspace-relative editor path: ${relPath}`)
  return normalized
}

function workspaceStoreKey(sessionId: string, workspaceFolder: string): string {
  return `${sessionId}\u0000${workspaceFolder.replaceAll('\\', '/').replace(/\/+$/, '').toLocaleLowerCase()}`
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function sameRevision(left: TextDocumentRevision, right: TextDocumentRevision): boolean {
  return left.sha256 === right.sha256 && left.size === right.size && left.modifiedAtNs === right.modifiedAtNs
}

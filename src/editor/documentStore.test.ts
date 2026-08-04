import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import { disposeEditorDocumentStore, EditorDocumentStore, getEditorDocumentStore, type EditorTextModel, type NativeTextDocument, type TextDocumentRevision } from './documentStore'

const revision = (sha256: string): TextDocumentRevision => ({ sha256, size: 4, modifiedAtNs: sha256 })
const opened = (content: string, sha256 = content): NativeTextDocument => ({
  content,
  revision: revision(sha256),
  encoding: 'utf8',
  lineEnding: 'lf',
})

type ModelFixture = { model: EditorTextModel; dispose: Mock; disposeSubscription: Mock }

function createModel(): ModelFixture {
  let value = ''
  const dispose = vi.fn()
  const disposeSubscription = vi.fn()
  return {
    dispose,
    disposeSubscription,
    model: {
      getValue: () => value,
      setValue: (next) => { value = next },
      onDidChangeContent: () => ({ dispose: disposeSubscription }),
      dispose,
    },
  }
}

beforeEach(() => {
  // mockReset returns the mock; returning it makes Vitest run it as a no-arg cleanup.
  invokeMock.mockReset()
})

describe('EditorDocumentStore', () => {
  it('deduplicates one document per normalized path and retains dirty state after view unmount', async () => {
    invokeMock.mockResolvedValue(opened('base'))
    const store = new EditorDocumentStore('session-1', 'C:/repo')
    store.retain('src\\file.ts')
    store.retain('src/file.ts')

    await Promise.all([store.load('src/file.ts'), store.load('src\\file.ts')])
    expect(invokeMock).toHaveBeenCalledTimes(1)
    expect(store.getDocument('src/file.ts')?.viewCount).toBe(2)

    store.updateCurrent('src/file.ts', 'local')
    store.release('src/file.ts')
    store.release('src/file.ts')
    expect(store.getDocument('src/file.ts')).toMatchObject({ current: 'local', dirty: true, viewCount: 0 })
  })

  it('keeps local content when the native optimistic save reports a conflict', async () => {
    let openCount = 0
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'fs_open_text_document') return ++openCount === 1 ? opened('base', 'one') : opened('disk', 'two')
      if (command === 'fs_save_text_document') return { status: 'conflict', currentRevision: revision('two') }
      throw new Error(`unexpected ${command}`)
    })
    const store = new EditorDocumentStore('session-1', 'C:/repo')
    await store.load('file.ts')
    store.updateCurrent('file.ts', 'local')

    await store.save('file.ts')

    expect(invokeMock).toHaveBeenNthCalledWith(2, 'fs_save_text_document', {
      workspaceFolder: 'C:/repo',
      relPath: 'file.ts',
      content: 'local',
      expectedRevision: revision('one'),
      encoding: 'utf8',
      lineEnding: 'lf',
    })
    expect(invokeMock).toHaveBeenNthCalledWith(3, 'fs_open_text_document', {
      workspaceFolder: 'C:/repo',
      relPath: 'file.ts',
    })
    expect(store.getDocument('file.ts')).toMatchObject({
      current: 'local',
      revision: revision('one'),
      dirty: true,
      conflict: { diskContent: 'disk', currentRevision: revision('two') },
    })
  })

  it('honors close cancellation without clearing local changes', async () => {
    invokeMock.mockResolvedValue(opened('base'))
    const store = new EditorDocumentStore('session-1', 'C:/repo')
    await store.load('file.ts')
    store.updateCurrent('file.ts', 'local')

    await expect(store.requestClose('file.ts', () => 'cancel')).resolves.toBe('cancelled')
    expect(store.getDocument('file.ts')).toMatchObject({ current: 'local', dirty: true })
  })

  it('save as never supplies an overwrite revision for a different path', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'fs_open_text_document') return opened('local')
      if (command === 'fs_save_text_document_as') return { status: 'conflict', currentRevision: revision('existing') }
      throw new Error(`unexpected ${command}`)
    })
    const store = new EditorDocumentStore('session-1', 'C:/repo')
    await store.load('folder\\file.ts')

    await store.saveAs('folder/file.ts', 'copies\\copy.ts')

    expect(invokeMock).toHaveBeenNthCalledWith(2, 'fs_save_text_document_as', {
      workspaceFolder: 'C:/repo',
      relPath: 'copies/copy.ts',
      content: 'local',
      expectedRevision: null,
      encoding: 'utf8',
      lineEnding: 'lf',
    })
  })

  it('evicts the least-recently-used clean closed document above the retained limit', async () => {
    invokeMock.mockImplementation(async (_command: string, args: { relPath: string }) => opened(args.relPath))
    const store = new EditorDocumentStore('lru-session', 'C:/repo')
    const models: ModelFixture[] = []

    for (let index = 0; index < 24; index += 1) {
      const path = `file-${index}.ts`
      store.retain(path)
      await store.load(path)
      const model = createModel()
      models.push(model)
      store.attachModel(path, model.model)
      store.release(path)
    }
    expect(store.getDocument('file-0.ts')).not.toBeNull()

    store.retain('file-24.ts')
    await store.load('file-24.ts')
    store.attachModel('file-24.ts', createModel().model)
    store.release('file-24.ts')

    expect(store.listDocuments()).toHaveLength(24)
    expect(store.getDocument('file-0.ts')).not.toBeNull()
    expect(store.getDocument('file-1.ts')).toBeNull()
    expect(models[0].dispose).not.toHaveBeenCalled()
    expect(models[1].dispose).toHaveBeenCalledOnce()
    expect(models[1].disposeSubscription).toHaveBeenCalledOnce()
  })

  it('never evicts dirty documents or documents with a live view', async () => {
    invokeMock.mockImplementation(async (_command: string, args: { relPath: string }) => opened(args.relPath))
    const store = new EditorDocumentStore('protected-session', 'C:/repo')
    const models: ModelFixture[] = []

    for (let index = 0; index < 24; index += 1) {
      const path = `file-${index}.ts`
      store.retain(path)
      await store.load(path)
      const model = createModel()
      models.push(model)
      store.attachModel(path, model.model)
      store.release(path)
    }
    store.updateCurrent('file-0.ts', 'unsaved')
    store.retain('file-1.ts')

    for (let index = 24; index < 26; index += 1) {
      const path = `file-${index}.ts`
      store.retain(path)
      await store.load(path)
      store.attachModel(path, createModel().model)
      store.release(path)
    }

    expect(store.listDocuments()).toHaveLength(24)
    expect(store.getDocument('file-0.ts')).toMatchObject({ dirty: true, viewCount: 0 })
    expect(store.getDocument('file-1.ts')).toMatchObject({ dirty: false, viewCount: 1 })
    expect(models[0].dispose).not.toHaveBeenCalled()
    expect(models[1].dispose).not.toHaveBeenCalled()
  })

  it('disposes a stale workspace store when the same session moves folders', async () => {
    invokeMock.mockResolvedValue(opened('base'))
    const oldStore = getEditorDocumentStore('moved-session', 'C:/old-repo')
    const model = createModel()
    oldStore.retain('file.ts')
    await oldStore.load('file.ts')
    oldStore.attachModel('file.ts', model.model)

    const currentStore = getEditorDocumentStore('moved-session', 'D:/new-repo')

    expect(currentStore).not.toBe(oldStore)
    expect(oldStore.listDocuments()).toEqual([])
    expect(model.dispose).toHaveBeenCalledOnce()
    expect(model.disposeSubscription).toHaveBeenCalledOnce()
    disposeEditorDocumentStore('moved-session')
  })
})

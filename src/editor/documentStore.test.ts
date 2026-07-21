import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import { EditorDocumentStore, type NativeTextDocument, type TextDocumentRevision } from './documentStore'

const revision = (sha256: string): TextDocumentRevision => ({ sha256, size: 4, modifiedAtNs: sha256 })
const opened = (content: string, sha256 = content): NativeTextDocument => ({
  content,
  revision: revision(sha256),
  encoding: 'utf8',
  lineEnding: 'lf',
})

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
})

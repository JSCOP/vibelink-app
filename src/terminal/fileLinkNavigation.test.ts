import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceContentActions } from '../layout/contentActions'
import { registerEditorNavigation } from '../editor/editorNavigation'
import { useExplorerStore } from '../state/explorer'
const invokeMock = vi.hoisted(() => vi.fn())
const toastError = vi.hoisted(() => vi.fn())
const revealPath = vi.fn(async () => {})
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('../components/toast/toastStore', () => ({ toast: { error: toastError } }))
import {
  openTerminalLinkTarget,
  parseTerminalOpenTarget,
  workspaceRelativePathForTerminalTarget,
} from './fileLinkNavigation'

describe('terminal file link navigation', () => {
  beforeEach(() => {
    toastError.mockReset()
    invokeMock.mockReset().mockResolvedValue('textFile')
    revealPath.mockReset()
    useExplorerStore.setState({ sessions: {}, revealPath })
  })

  it('parses line/column links and OMP Read range selectors', () => {
    expect(parseTerminalOpenTarget('E:/repo/src/App.tsx:120:7')).toEqual({
      path: 'E:/repo/src/App.tsx',
      location: { lineNumber: 120, column: 7 },
    })
    expect(parseTerminalOpenTarget('E:/repo/src/App.tsx:120-230,410-450')).toEqual({
      path: 'E:/repo/src/App.tsx',
      location: { lineNumber: 120, column: 1 },
    })
    expect(parseTerminalOpenTarget('E:/repo/src/App.tsx:raw:410-450')).toEqual({
      path: 'E:/repo/src/App.tsx',
      location: { lineNumber: 410, column: 1 },
    })
    expect(parseTerminalOpenTarget('https://example.com:8443/path')).toEqual({
      path: 'https://example.com:8443/path',
    })
  })

  it('maps Windows paths inside the active workspace case-insensitively', () => {
    expect(workspaceRelativePathForTerminalTarget(
      'e:/VibeCodingProject/VibeLink/vibelink-app/src/App.tsx',
      'E:\\VibeCodingProject\\VibeLink\\vibelink-app',
    )).toBe('src/App.tsx')
    expect(workspaceRelativePathForTerminalTarget(
      'E:/VibeCodingProject/VibeLink/vibelink-app',
      'E:\\VibeCodingProject\\VibeLink\\vibelink-app',
    )).toBe('')
    expect(workspaceRelativePathForTerminalTarget(
      'E:/VibeCodingProject/vibelink-web/apps/web/app/page.tsx',
      'E:/VibeCodingProject/vibelink/vibelink-app',
    )).toBeNull()
  })

  it('opens a located workspace file in VibeLink and reveals the requested line', async () => {
    const openContent = vi.fn(async () => 'content:editor:src/App.tsx')
    const openSystemPath = vi.fn()
    const reveal = vi.fn()
    const unregister = registerEditorNavigation('session-1', 'src/App.tsx', reveal)

    await openTerminalLinkTarget(parseTerminalOpenTarget(
      'E:/VibeCodingProject/vibelink/vibelink-app/src/App.tsx:120-230,410-450',
    ), 'internal', {
      activeSessionId: 'session-1',
      workspaceFolder: 'E:/VibeCodingProject/vibelink/vibelink-app',
      workspaceEpoch: 9,
      contentActions: { openContent } as unknown as WorkspaceContentActions,
      openSystemPath,
      isOwnershipCurrent: () => true,
    })

    expect(openContent).toHaveBeenCalledWith({
      kind: 'editor',
      relPath: 'src/App.tsx',
      workspaceId: 'session-1',
      workspaceEpoch: 9,
    })
    expect(reveal).toHaveBeenCalledWith({ lineNumber: 120, column: 1 })
    expect(openSystemPath).not.toHaveBeenCalled()
    unregister()
  })

  it('opens a plain workspace text file in the VibeLink editor', async () => {
    const openContent = vi.fn(async () => 'content:editor:README.md')
    const openSystemPath = vi.fn()

    await openTerminalLinkTarget(parseTerminalOpenTarget('E:/repo/README.md'), 'internal', {
      activeSessionId: 'session-1',
      workspaceFolder: 'E:/repo',
      workspaceEpoch: 3,
      contentActions: { openContent } as unknown as WorkspaceContentActions,
      openSystemPath,
    })

    expect(invokeMock).toHaveBeenCalledWith('fs_path_kind', { workspaceFolder: 'E:/repo', relPath: 'README.md' })
    expect(openContent).toHaveBeenCalledWith({ kind: 'editor', relPath: 'README.md', workspaceId: 'session-1', workspaceEpoch: 3 })
    expect(openSystemPath).not.toHaveBeenCalled()
  })

  it('reveals workspace folders and non-text files in the VibeLink Explorer', async () => {
    invokeMock.mockResolvedValueOnce('directory')
    const openContent = vi.fn(async () => 'content:explorer:explorer')
    const openSystemPath = vi.fn()

    await openTerminalLinkTarget(parseTerminalOpenTarget('E:/repo/src'), 'internal', {
      activeSessionId: 'session-1',
      workspaceFolder: 'E:/repo',
      workspaceEpoch: 4,
      contentActions: { openContent } as unknown as WorkspaceContentActions,
      openSystemPath,
    })

    expect(openContent).toHaveBeenCalledWith({ kind: 'explorer', workspaceId: 'session-1', workspaceEpoch: 4 })
    expect(revealPath).toHaveBeenCalledWith('session-1', 'E:/repo', 'src')
    expect(openSystemPath).not.toHaveBeenCalled()
  })

  it('uses the Windows default association for Ctrl+Shift clicks inside the workspace', async () => {
    const openContent = vi.fn()
    const openSystemPath = vi.fn()

    await openTerminalLinkTarget(parseTerminalOpenTarget('E:/repo/src/App.tsx:42'), 'system', {
      activeSessionId: 'session-1',
      workspaceFolder: 'E:/repo',
      workspaceEpoch: 5,
      contentActions: { openContent } as unknown as WorkspaceContentActions,
      openSystemPath,
    })

    expect(invokeMock).not.toHaveBeenCalled()
    expect(openContent).not.toHaveBeenCalled()
    expect(openSystemPath).toHaveBeenCalledWith('E:/repo/src/App.tsx')
  })

  it('strips the selector before using the system fallback outside the workspace', async () => {
    const openContent = vi.fn()
    const openSystemPath = vi.fn()

    await openTerminalLinkTarget(parseTerminalOpenTarget('D:/other/file.ts:42'), 'internal', {
      activeSessionId: 'session-1',
      workspaceFolder: 'E:/repo',
      workspaceEpoch: 1,
      contentActions: { openContent } as unknown as WorkspaceContentActions,
      openSystemPath,
    })

    expect(openContent).not.toHaveBeenCalled()
    expect(openSystemPath).toHaveBeenCalledWith('D:/other/file.ts')
  })

  it('reports system-open failures through an error toast', async () => {
    const openSystemPath = vi.fn(async () => { throw new Error('ShellExecute failed') })

    await openTerminalLinkTarget(parseTerminalOpenTarget('D:/other/file.ts'), 'system', {
      workspaceEpoch: 1,
      contentActions: null,
      openSystemPath,
    })

    expect(toastError).toHaveBeenCalledWith('Could not open terminal link: Error: ShellExecute failed')
  })
})

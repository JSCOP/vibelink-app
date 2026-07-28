import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceContentActions } from '../layout/contentActions'
import { registerEditorNavigation } from '../editor/editorNavigation'
const toastError = vi.hoisted(() => vi.fn())
vi.mock('../components/toast/toastStore', () => ({ toast: { error: toastError } }))
import {
  openTerminalLinkTarget,
  parseTerminalOpenTarget,
  workspaceRelativePathForTerminalTarget,
} from './fileLinkNavigation'

describe('terminal file link navigation', () => {
  beforeEach(() => toastError.mockReset())

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
    ), {
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

  it('strips the selector before using the system fallback outside the workspace', async () => {
    const openContent = vi.fn()
    const openSystemPath = vi.fn()

    await openTerminalLinkTarget(parseTerminalOpenTarget('D:/other/file.ts:42'), {
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

    await openTerminalLinkTarget(parseTerminalOpenTarget('D:/other/file.ts'), {
      workspaceEpoch: 1,
      contentActions: null,
      openSystemPath,
    })

    expect(toastError).toHaveBeenCalledWith('Could not open terminal link: Error: ShellExecute failed')
  })
})

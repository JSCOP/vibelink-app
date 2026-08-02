// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { WorkspaceContentActionsContext, type WorkspaceContentActions } from '../../layout/contentActions'
import { defaultSettings, normalizeSettings } from '../../state/profiles'
import { resetWorkspaceSessionOwnershipForTests, useWorkspaceStore } from '../../state/store'
import { PreviewContentPanel } from './PreviewContentPanel'

const actions: WorkspaceContentActions = {
  openContent: vi.fn(async () => ''),
  activateContent: vi.fn(),
  requestCloseContent: vi.fn(async (): Promise<'closed' | 'cancelled'> => 'closed'),
  splitTerminal: vi.fn(async () => undefined),
  arrangeTerminals: vi.fn(async () => undefined),
  clearTerminals: vi.fn(async () => undefined),
  toggleMaximizeContent: vi.fn(),
  toggleZoomContent: vi.fn(),
  toggleTerminalWindowTitles: vi.fn(),
  renameTerminal: vi.fn(async () => undefined),
  resetLayout: vi.fn(async () => undefined),
  getContentParams: vi.fn(() => null),
}

beforeEach(async () => {
  cleanup()
  resetWorkspaceSessionOwnershipForTests()
  invoke.mockReset()
  vi.mocked(actions.openContent).mockClear()
  invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'attach_session') return {
      layoutJson: null,
      panes: [{ id: 'pane-test', config: { paneId: 'pane-test', shell: 'pwsh.exe', args: [], cwd: 'C:/repo', env: [], title: 'PowerShell', cols: 120, rows: 32 }, alive: true }],
    }
    if (command === 'fs_list_dir') {
      const name = String(args?.relPath ?? '')
      if (name === '') return [
        { name: 'large.png', isDir: false, isSymlink: false, size: 21 * 1024 * 1024, modifiedAt: null },
        { name: 'notes.txt', isDir: false, isSymlink: false, size: 3 * 1024 * 1024, modifiedAt: null },
        { name: 'binary.bin', isDir: false, isSymlink: false, size: 1024, modifiedAt: null },
        { name: 'README.md', isDir: false, isSymlink: false, size: 128, modifiedAt: null },
        { name: 'manual.pdf', isDir: false, isSymlink: false, size: 4096, modifiedAt: null },
      ]
    }
    if (command === 'fs_read_image') return 'aW1hZ2U='
    if (command === 'fs_read_text' && args?.relPath === 'notes.txt') return { content: 'truncated text', truncated: true, binary: false }
    if (command === 'fs_read_text' && args?.relPath === 'binary.bin') return { content: '', truncated: false, binary: true }
    if (command === 'fs_read_text' && args?.relPath === 'README.md') return { content: '# Guide\n\n| A | B |\n| - | - |\n| 1 | 2 |', truncated: false, binary: false }
    return null
  })
  useWorkspaceStore.setState({
    activeSessionId: undefined,
    workspaceEpoch: 0,
    workspaceReadyEpoch: 0,
    panes: {},
    license: { ready: false, status: null },
    sessions: [{ id: 'session-1', name: 'Repo', paneCount: 0, createdAt: 1, workspaceFolder: 'C:/repo' }],
    settings: normalizeSettings(defaultSettings),
  })
  await useWorkspaceStore.getState().attachSession('session-1')
})

describe('PreviewContentPanel', () => {
  test('preserves large image dimensions, truncated text, and binary states while reusing one panel', async () => {
    const view = render(
      <WorkspaceContentActionsContext.Provider value={actions}>
        <PreviewContentPanel sessionId="session-1" workspaceFolder="C:/repo" relPath="large.png" />
      </WorkspaceContentActionsContext.Provider>,
    )

    const image = await screen.findByAltText('large.png')
    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 4096 })
    Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 2160 })
    fireEvent.load(image)
    expect(await screen.findByText('4096 × 2160 px')).toBeTruthy()
    expect(screen.getByText('21.0 MiB')).toBeTruthy()

    view.rerender(
      <WorkspaceContentActionsContext.Provider value={actions}>
        <PreviewContentPanel sessionId="session-1" workspaceFolder="C:/repo" relPath="notes.txt" />
      </WorkspaceContentActionsContext.Provider>,
    )
    expect(await screen.findByText('truncated text')).toBeTruthy()
    expect(screen.getByText('Preview truncated at 2 MiB.')).toBeTruthy()

    view.rerender(
      <WorkspaceContentActionsContext.Provider value={actions}>
        <PreviewContentPanel sessionId="session-1" workspaceFolder="C:/repo" relPath="binary.bin" />
      </WorkspaceContentActionsContext.Provider>,
    )
    expect(await screen.findByText('Binary file')).toBeTruthy()
    expect(screen.getByText('Preview is unavailable for this file type.')).toBeTruthy()
    await waitFor(() => expect(document.querySelectorAll('[data-explorer-viewer="true"]')).toHaveLength(1))
  })

  test('renders a bounded missing-file error without affecting Explorer state', async () => {
    render(
      <WorkspaceContentActionsContext.Provider value={actions}>
        <PreviewContentPanel sessionId="session-1" workspaceFolder="C:/repo" relPath="missing.txt" />
      </WorkspaceContentActionsContext.Provider>,
    )

    expect((await screen.findByRole('alert')).textContent).toContain('File does not exist: missing.txt')
  })

  test('routes Markdown through the lazy rich preview and PDFs to the default-viewer action', async () => {
    const view = render(
      <WorkspaceContentActionsContext.Provider value={actions}>
        <PreviewContentPanel sessionId="session-1" workspaceFolder="C:/repo" relPath="README.md" />
      </WorkspaceContentActionsContext.Provider>,
    )
    expect(await screen.findByRole('heading', { name: 'Guide' })).toBeTruthy()
    expect(document.querySelector('table')).toBeTruthy()

    view.rerender(
      <WorkspaceContentActionsContext.Provider value={actions}>
        <PreviewContentPanel sessionId="session-1" workspaceFolder="C:/repo" relPath="manual.pdf" />
      </WorkspaceContentActionsContext.Provider>,
    )
    expect(await screen.findByText('Binary file')).toBeTruthy()
    expect(screen.getByTitle('Open with the default application')).toBeTruthy()
    expect(actions.openContent).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalledWith('fs_read_text', expect.objectContaining({ relPath: 'manual.pdf' }))
  })
})

// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const { invoke, registerThemes, setTheme } = vi.hoisted(() => ({ invoke: vi.fn(), registerThemes: vi.fn((_monaco: unknown, themeId: string) => themeId === 'oneHalfLight' ? 'vibelink-light' : 'vibelink-dark'), setTheme: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@monaco-editor/react', () => ({ default: () => null }))
vi.mock('./monaco', () => ({ monaco: { editor: { setTheme, defineTheme: vi.fn() } } }))
vi.mock('./editorTheme', () => ({
  registerVibeLinkMonacoThemes: registerThemes,
  vibeLinkMonacoThemeName: (themeId: string) => themeId === 'oneHalfLight' ? 'vibelink-light' : 'vibelink-dark',
}))

import { WorkspaceContentActionsContext, type WorkspaceContentActions } from '../layout/contentActions'
import { emptyGitRepositoryState, useGitStore } from '../state/git'
import { defaultSettings, normalizeSettings } from '../state/profiles'
import { resetWorkspaceSessionOwnershipForTests, useWorkspaceStore } from '../state/store'
import { disposeEditorDocumentStore } from './documentStore'
import { EditorContentPanel, type MonacoEditorHandle, type MonacoEditorSurfaceProps } from './EditorContentPanel'
import { requestEditorNavigation } from './editorNavigation'

let latestSurfaceProps: MonacoEditorSurfaceProps | null = null
let mountCount = 0
const setPosition = vi.fn()
const revealPositionInCenter = vi.fn()

function FakeMonacoEditor(props: MonacoEditorSurfaceProps) {
  const { onMount } = props
  const valueRef = useRef(props.value)
  const languageRef = useRef(props.language)
  useEffect(() => {
    latestSurfaceProps = props
    valueRef.current = props.value
    languageRef.current = props.language
  }, [props])
  const modelRef = useRef({
    getValue: () => valueRef.current,
    setValue: (value: string) => { valueRef.current = value },
    onDidChangeContent: () => ({ dispose: vi.fn() }),
    dispose: vi.fn(),
    getOptions: () => ({ tabSize: 2, insertSpaces: true }),
    getLanguageId: () => languageRef.current ?? 'plaintext',
  })
  const editorRef = useRef<MonacoEditorHandle>({
    getModel: () => modelRef.current,
    getPosition: () => ({ lineNumber: 3, column: 7 }),
    setPosition,
    revealPositionInCenter,
    focus: vi.fn(),
    layout: vi.fn(),
    updateOptions: vi.fn(),
    onDidChangeCursorPosition: () => ({ dispose: vi.fn() }),
    onDidChangeModelOptions: () => ({ dispose: vi.fn() }),
  })
  useEffect(() => {
    mountCount += 1
    onMount?.(editorRef.current)
  }, [onMount])
  return <textarea aria-label="Fake Monaco" value={props.value} onChange={(event) => props.onChange?.(event.target.value)} />
}

const openContent = vi.fn(async () => '')
const actions: WorkspaceContentActions = {
  openContent,
  activateContent: vi.fn(),
  requestCloseContent: vi.fn(async (): Promise<'closed' | 'cancelled'> => 'closed'),
  splitTerminal: vi.fn(async () => undefined),
  arrangeTerminals: vi.fn(async () => undefined),
  clearTerminals: vi.fn(async () => undefined),
  toggleMaximizeContent: vi.fn(),
  toggleZoomContent: vi.fn(),
  toggleTerminalWindowTitles: vi.fn(),
  renameContent: vi.fn(async () => undefined),
  resetLayout: vi.fn(async () => undefined),
  getContentParams: vi.fn(() => null),
}

beforeEach(async () => {
  cleanup()
  disposeEditorDocumentStore('editor-session')
  resetWorkspaceSessionOwnershipForTests()
  latestSurfaceProps = null
  mountCount = 0
  openContent.mockClear()
  registerThemes.mockClear()
  setTheme.mockClear()
  setPosition.mockClear()
  revealPositionInCenter.mockClear()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  invoke.mockReset()
  invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'attach_session') return {
      layoutJson: null,
      panes: [{ id: 'pane-test', config: { paneId: 'pane-test', shell: 'pwsh.exe', args: [], cwd: 'C:/repo', env: [], title: 'PowerShell', cols: 120, rows: 32 }, alive: true }],
    }
    if (command === 'fs_open_text_document') return {
      content: 'const value = 1\n',
      revision: { sha256: 'one', size: 16, modifiedAtNs: '1' },
      encoding: 'utf8',
      lineEnding: 'lf',
    }
    if (command === 'fs_text_document_revision') return { sha256: 'one', size: 16, modifiedAtNs: '1' }
    if (command === 'fs_list_dir') return []
    if (command === 'git_check_ignored') return []
    return args ?? null
  })
  useWorkspaceStore.setState({
    activeSessionId: undefined,
    workspaceEpoch: 0,
    workspaceReadyEpoch: 0,
    panes: {},
    sessions: [{ id: 'editor-session', name: 'Repo', paneCount: 0, createdAt: 1, workspaceFolder: 'C:/repo' }],
    settings: normalizeSettings(defaultSettings),
  })
  useGitStore.setState({
    sessions: {
      'editor-session': {
        repositories: {
          '': {
            ...emptyGitRepositoryState,
            status: { staged: [], unstaged: [{ path: 'src/app.ts', oldPath: null, changeType: 'modified' }], untracked: [], conflicted: [], truncated: false },
          },
        },
        activeRepoRoot: '',
        selectedPath: null,
        selectedRepoRoot: '',
        selectedArea: null,
        activeTab: 'changes',
        pathFilter: null,
      },
    },
  })
  await useWorkspaceStore.getState().attachSession('editor-session')
})

function renderEditor() {
  return render(
    <WorkspaceContentActionsContext.Provider value={actions}>
      <EditorContentPanel sessionId="editor-session" workspaceFolder="C:/repo" relPath="src/app.ts" MonacoEditor={FakeMonacoEditor} />
    </WorkspaceContentActionsContext.Provider>,
  )
}

describe('EditorContentPanel', () => {
  test('keeps the Monaco model and dirty text across synchronized theme changes', async () => {
    renderEditor()
    const editor = await screen.findByLabelText('Fake Monaco')
    await waitFor(() => expect(latestSurfaceProps?.language).toBe('typescript'))
    expect(latestSurfaceProps?.options).toMatchObject({ wordWrap: 'on', minimap: { enabled: false }, renderWhitespace: 'selection', disableLayerHinting: true })
    expect(screen.getByText('Ln 3, Col 7')).toBeTruthy()
    expect(screen.getByText('Spaces: 2')).toBeTruthy()

    fireEvent.change(editor, { target: { value: 'const value = 2\n' } })
    expect(await screen.findByText('Modified')).toBeTruthy()

    act(() => {
      useWorkspaceStore.setState((state) => ({ settings: { ...state.settings, terminalThemeId: 'oneHalfLight' } }))
    })

    expect((screen.getByLabelText('Fake Monaco') as HTMLTextAreaElement).value).toBe('const value = 2\n')
    expect(latestSurfaceProps?.path).toBe('vibelink-editor://editor-session/src/app.ts')
    expect(latestSurfaceProps?.keepCurrentModel).toBe(true)
    expect(latestSurfaceProps?.theme).toBe('vibelink-light')
    expect(mountCount).toBe(1)
    expect(registerThemes).toHaveBeenLastCalledWith(expect.anything(), 'oneHalfLight')
    expect(setTheme).toHaveBeenLastCalledWith('vibelink-light')
  })

  test('persists wrap/minimap controls and routes Explorer, history, and changes actions', async () => {
    renderEditor()
    await screen.findByLabelText('Fake Monaco')

    fireEvent.click(screen.getByTitle('Toggle word wrap'))
    fireEvent.click(screen.getByTitle('Toggle minimap'))
    expect(useWorkspaceStore.getState().settings).toMatchObject({ editorWordWrap: false, editorMinimap: true })

    fireEvent.click(screen.getByRole('button', { name: 'More editor actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reveal in Explorer' }))
    await waitFor(() => expect(openContent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'explorer' })))

    fireEvent.click(screen.getByRole('button', { name: 'More editor actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'File History' }))
    await waitFor(() => expect(openContent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'gitHistory' })))

    fireEvent.click(screen.getByRole('button', { name: 'More editor actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open Changes' }))
    await waitFor(() => {
      expect(openContent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'sourceControl' }))
      expect(openContent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'workbench' }))
    })
  })

  test('reveals a pending terminal file-link line after Monaco mounts', async () => {
    requestEditorNavigation('editor-session', 'src/app.ts', { lineNumber: 120, column: 1 })
    renderEditor()

    await screen.findByLabelText('Fake Monaco')
    await waitFor(() => expect(setPosition).toHaveBeenCalledWith({ lineNumber: 120, column: 1 }))
    expect(revealPositionInCenter).toHaveBeenCalledWith({ lineNumber: 120, column: 1 })
  })
})

import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { PaneMeta, SessionMeta } from '../ipc/types'
import { defaultSettings, normalizeSettings } from './profiles'
import { useWorkspaceStore } from './store'

const spawnedPane: PaneMeta = {
  id: 'pane-test',
  config: {
    paneId: 'pane-test',
    shell: 'codex.cmd',
    args: ['--dangerously-bypass-approvals-and-sandbox'],
    cwd: 'E:/work',
    env: [['TERM_PROGRAM', 'AgenticWorkspaceTerminal']],
    title: 'Codex',
    cols: 120,
    rows: 32,
  },
  alive: true,
}

const createdSession: SessionMeta = {
  id: 'session-workspace',
  name: 'Repo',
  paneCount: 0,
  createdAt: 123,
  workspaceFolder: 'E:/repo',
}

const localStorageStub = {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
}

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string) => {
    if (command === 'spawn_pane') return spawnedPane
    if (command === 'list_sessions') return []
    return null
  }),
}))

describe('workspace store profiles', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { localStorage: localStorageStub })
    localStorageStub.getItem.mockReturnValue(null)
    localStorageStub.setItem.mockClear()
    localStorageStub.removeItem.mockClear()
    localStorageStub.clear.mockClear()
    vi.mocked(invoke).mockClear()
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'spawn_pane') return spawnedPane
      if (command === 'list_sessions') return []
      return null
    })
    useWorkspaceStore.setState({
      sessions: [],
      activeSessionId: undefined,
      panes: {},
      manualPaneTitles: {},
      layoutJson: null,
      status: 'ready',
      error: undefined,
      settings: normalizeSettings({
        ...defaultSettings,
        defaultProfileId: 'agent',
        profiles: [
          {
            id: 'agent',
            name: 'Codex',
            shell: 'codex.cmd',
            args: ['--dangerously-bypass-approvals-and-sandbox'],
            env: [['TERM_PROGRAM', 'AgenticWorkspaceTerminal']],
            cwd: 'E:/work',
            color: '#7ee787',
            icon: 'sparkles',
          },
        ],
      }),
    })
  })

  test('spawnPane uses the selected profile when no pane overrides are supplied', async () => {
    await useWorkspaceStore.getState().spawnPane('session-1', { paneId: 'pane-test' })

    expect(invoke).toHaveBeenNthCalledWith(1, 'spawn_pane', {
      sessionId: 'session-1',
      cfg: {
        paneId: 'pane-test',
        shell: 'codex.cmd',
        args: ['--dangerously-bypass-approvals-and-sandbox'],
        cwd: 'E:/work',
        env: [['TERM_PROGRAM', 'AgenticWorkspaceTerminal']],
        title: 'Codex',
        cols: 120,
        rows: 32,
      },
    })
  })

  test('createSession persists a workspace folder and launches the initial pane there', async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'create_session') return createdSession
      if (command === 'list_sessions') return [createdSession]
      if (command === 'attach_session') return { layoutJson: null, panes: [] }
      if (command === 'spawn_pane') return spawnedPane
      return null
    })

    await useWorkspaceStore.getState().createSession('Repo', 'E:/repo')

    expect(invoke).toHaveBeenCalledWith('create_session', {
      name: 'Repo',
      workspaceFolder: 'E:/repo',
    })
    expect(invoke).toHaveBeenCalledWith('spawn_pane', {
      sessionId: 'session-workspace',
      cfg: expect.objectContaining({ cwd: 'E:/repo' }),
    })
  })

  test('spawnPane prefers the session workspace folder over the active profile cwd', async () => {
    useWorkspaceStore.setState({ sessions: [createdSession], activeSessionId: createdSession.id })

    await useWorkspaceStore.getState().spawnPane(createdSession.id, { paneId: 'pane-test' })

    expect(invoke).toHaveBeenCalledWith('spawn_pane', {
      sessionId: 'session-workspace',
      cfg: expect.objectContaining({ cwd: 'E:/repo' }),
    })
  })

  test('spawnPane preserves an explicit cwd override when a session has a workspace folder', async () => {
    useWorkspaceStore.setState({ sessions: [createdSession], activeSessionId: createdSession.id })

    await useWorkspaceStore.getState().spawnPane(createdSession.id, { paneId: 'pane-test', cwd: null })

    expect(invoke).toHaveBeenCalledWith('spawn_pane', {
      sessionId: 'session-workspace',
      cfg: expect.objectContaining({ cwd: null }),
    })
  })

  test('renamePaneTitle persists a manual title and updates local pane metadata', async () => {
    useWorkspaceStore.setState({ panes: { 'pane-test': spawnedPane } })

    await useWorkspaceStore.getState().renamePaneTitle('pane-test', 'Manual Codex', 'manual')

    expect(invoke).toHaveBeenCalledWith('set_pane_title', { paneId: 'pane-test', title: 'Manual Codex' })
    expect(useWorkspaceStore.getState().panes['pane-test'].config.title).toBe('Manual Codex')
  })

  test('applyTerminalTitle does not overwrite manual pane titles', async () => {
    useWorkspaceStore.setState({ panes: { 'pane-test': spawnedPane } })
    await useWorkspaceStore.getState().renamePaneTitle('pane-test', 'Manual Codex', 'manual')

    await useWorkspaceStore.getState().applyTerminalTitle('pane-test', 'Codex: auto task')

    expect(useWorkspaceStore.getState().panes['pane-test'].config.title).toBe('Manual Codex')
  })
})

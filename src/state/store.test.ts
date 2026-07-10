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
    env: [['TERM_PROGRAM', 'VibeLink']],
    title: 'Codex',
    cols: 120,
    rows: 32,
  },
  alive: true,
}

const nonAgentPane: PaneMeta = {
  id: 'pane-shell',
  config: {
    paneId: 'pane-shell',
    shell: 'pwsh.exe',
    args: ['-NoLogo'],
    cwd: 'E:/work',
    env: [['TERM_PROGRAM', 'VibeLink']],
    title: 'PowerShell',
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

const secondSession: SessionMeta = {
  id: 'session-other',
  name: 'Other',
  paneCount: 0,
  createdAt: 124,
  workspaceFolder: 'E:/other',
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
    vi.stubGlobal('document', { hasFocus: () => false })
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
      activePaneId: undefined,
      panes: {},
      manualPaneTitles: {},
      layoutJson: null,
      status: 'ready',
      error: undefined,
      hermesPendingPrompts: {},
      hermesTranscript: {},
      hermesCurrentSession: {},
      paneCompletionHighlights: {},
      capturesByPane: {},
      recentCaptures: [],
      hermesSessions: {},
      settings: normalizeSettings({
        ...defaultSettings,
        defaultProfileId: 'agent',
        profiles: [
          {
            id: 'agent',
            name: 'Codex',
            shell: 'codex.cmd',
            args: ['--dangerously-bypass-approvals-and-sandbox'],
            env: [['TERM_PROGRAM', 'VibeLink']],
            cwd: 'E:/work',
            color: '#7ee787',
            icon: 'sparkles',
          },
        ],
      }),
    })
  })

  test('dismissError clears only the notification', () => {
    useWorkspaceStore.setState({ status: 'error', error: 'boom' })

    useWorkspaceStore.getState().dismissError()

    expect(useWorkspaceStore.getState().error).toBeUndefined()
    expect(useWorkspaceStore.getState().status).toBe('error')
  })

  test('spawnPane advertises color terminal capabilities by default', async () => {
    await useWorkspaceStore.getState().spawnPane('session-1', { paneId: 'pane-test' })

    expect(invoke).toHaveBeenCalledWith('spawn_pane', {
      sessionId: 'session-1',
      cfg: expect.objectContaining({
        env: expect.arrayContaining([
          ['TERM', 'xterm-256color'],
          ['COLORTERM', 'truecolor'],
          ['FORCE_COLOR', '1'],
          ['CLICOLOR_FORCE', '1'],
          ['TERM_PROGRAM', 'VibeLink'],
        ]),
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
        env: [
          ['TERM', 'xterm-256color'],
          ['COLORTERM', 'truecolor'],
          ['FORCE_COLOR', '1'],
          ['CLICOLOR_FORCE', '1'],
          ['TERM_PROGRAM', 'VibeLink'],
          ['VIBELINK_SESSION_ID', 'session-1'],
          ['VIBELINK_PANE_ID', 'pane-test'],
          ['VIBELINK_APP_EXE', 'app.exe'],
        ],
        title: 'Codex',
        icon: 'sparkles',
        profileId: 'agent',
        cols: 120,
        rows: 32,
      },
    })
  })

  test('spawnPane exposes pane and session ids to terminal agents', async () => {
    await useWorkspaceStore.getState().spawnPane('session-1', { paneId: 'pane-test' })

    expect(invoke).toHaveBeenCalledWith('spawn_pane', {
      sessionId: 'session-1',
      cfg: expect.objectContaining({
        env: expect.arrayContaining([
          ['VIBELINK_SESSION_ID', 'session-1'],
          ['VIBELINK_PANE_ID', 'pane-test'],
        ]),
      }),
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

  test('bootstrap loads sessions without auto-opening a workspace', async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'list_sessions') return [createdSession]
      if (command === 'attach_session') return { layoutJson: null, panes: [] }
      if (command === 'spawn_pane') return spawnedPane
      return null
    })

    await useWorkspaceStore.getState().bootstrap()

    expect(useWorkspaceStore.getState().sessions).toEqual([createdSession])
    expect(useWorkspaceStore.getState().activeSessionId).toBeUndefined()
    expect(useWorkspaceStore.getState().status).toBe('ready')
    expect(invoke).not.toHaveBeenCalledWith('attach_session', expect.anything())
    expect(invoke).not.toHaveBeenCalledWith('spawn_pane', expect.anything())
  })

  test('openSession launches an empty workspace pane in the workspace folder', async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'attach_session') return { layoutJson: null, panes: [] }
      if (command === 'list_sessions') return [createdSession]
      if (command === 'spawn_pane') return spawnedPane
      return null
    })
    useWorkspaceStore.setState({ sessions: [createdSession] })

    await useWorkspaceStore.getState().openSession(createdSession.id)

    expect(invoke).toHaveBeenCalledWith('attach_session', { sessionId: createdSession.id })
    expect(invoke).toHaveBeenCalledWith('spawn_pane', {
      sessionId: 'session-workspace',
      cfg: expect.objectContaining({ cwd: 'E:/repo' }),
    })
  })

  test('createSession launches the initial pane with the requested profile', async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'create_session') return createdSession
      if (command === 'list_sessions') return [createdSession]
      if (command === 'attach_session') return { layoutJson: null, panes: [] }
      if (command === 'spawn_pane') return spawnedPane
      return null
    })
    useWorkspaceStore.setState({
      settings: normalizeSettings({
        ...defaultSettings,
        defaultProfileId: 'agent',
        profiles: [
          {
            id: 'ssh-dev',
            name: 'SSH Dev',
            type: 'ssh',
            sshHost: 'dev.example.com',
            sshUser: 'me',
            sshRemoteCwd: '/srv/app',
            env: [],
            cwd: 'E:/local-ssh-launch-dir',
            color: '#76e3ea',
            icon: 'radio-tower',
          },
        ],
      }),
    })

    await useWorkspaceStore.getState().createSession('Remote', 'E:/repo', 'ssh-dev')

    expect(invoke).toHaveBeenCalledWith('spawn_pane', {
      sessionId: 'session-workspace',
      cfg: expect.objectContaining({
        shell: 'ssh',
        args: ['-t', 'me@dev.example.com', "cd -- 'E:/repo' && exec \"${SHELL:-sh}\" -l"],
        cwd: 'E:/local-ssh-launch-dir',
        title: 'SSH Dev',
      }),
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

  test('setDefaultProfile stores the active profile per workspace', async () => {
    useWorkspaceStore.setState({
      activeSessionId: createdSession.id,
      sessions: [createdSession, secondSession],
      settings: normalizeSettings({
        ...defaultSettings,
        defaultProfileId: 'agent',
        profiles: [
          {
            id: 'agent',
            name: 'Codex',
            shell: 'codex.cmd',
            args: [],
            env: [],
            cwd: null,
            color: '#7ee787',
            icon: 'bot',
          },
          {
            id: 'powershell',
            name: 'PowerShell',
            shell: 'pwsh.exe',
            args: ['-NoLogo'],
            env: [],
            cwd: null,
            color: '#58a6ff',
            icon: 'terminal-square',
          },
        ],
      }),
    })

    useWorkspaceStore.getState().setDefaultProfile('powershell')

    expect(useWorkspaceStore.getState().settings.defaultProfileId).toBe('agent')
    expect(useWorkspaceStore.getState().settings.workspaceProfileIds).toMatchObject({
      [createdSession.id]: 'powershell',
    })

    await useWorkspaceStore.getState().spawnPane(createdSession.id, { paneId: 'pane-test' })

    expect(invoke).toHaveBeenCalledWith('spawn_pane', {
      sessionId: createdSession.id,
      cfg: expect.objectContaining({
        shell: 'pwsh.exe',
        title: 'PowerShell',
      }),
    })
  })

  test('renamePaneTitle persists a manual title and updates local pane metadata', async () => {
    useWorkspaceStore.setState({ activeSessionId: createdSession.id, panes: { 'pane-test': spawnedPane } })

    await useWorkspaceStore.getState().renamePaneTitle('pane-test', 'Manual Codex', 'manual')

    expect(invoke).toHaveBeenCalledWith('set_pane_title', { sessionId: createdSession.id, paneId: 'pane-test', title: 'Manual Codex' })
    expect(useWorkspaceStore.getState().panes['pane-test'].config.title).toBe('Manual Codex')
  })

  test('renamePaneTitle skips unchanged titles', async () => {
    useWorkspaceStore.setState({
      activeSessionId: createdSession.id,
      panes: { 'pane-test': { ...spawnedPane, config: { ...spawnedPane.config, title: 'Manual Codex' } } },
    })

    await useWorkspaceStore.getState().renamePaneTitle('pane-test', 'Manual Codex', 'manual')

    expect(invoke).not.toHaveBeenCalledWith('set_pane_title', expect.anything())
  })

  test('applyPaneConfiguration skips unchanged titles', () => {
    useWorkspaceStore.setState({
      panes: { 'pane-test': { ...spawnedPane, config: { ...spawnedPane.config, title: 'Same' } } },
      manualPaneTitles: {},
    })

    useWorkspaceStore.getState().applyPaneConfiguration('pane-test', { title: 'Same' })

    expect(useWorkspaceStore.getState().manualPaneTitles['pane-test']).toBeUndefined()
  })

  test('applyTerminalTitle does not overwrite manual pane titles', async () => {
    useWorkspaceStore.setState({ activeSessionId: createdSession.id, panes: { 'pane-test': spawnedPane } })
    await useWorkspaceStore.getState().renamePaneTitle('pane-test', 'Manual Codex', 'manual')

    await useWorkspaceStore.getState().applyTerminalTitle('pane-test', 'Codex: auto task')

    expect(useWorkspaceStore.getState().panes['pane-test'].config.title).toBe('Manual Codex')
  })

  test('stores Hermes session metadata and replaces transcripts', () => {
    const store = useWorkspaceStore.getState()

    store.addHermesUserMessage('session-1', 'old')
    store.setHermesTranscript('session-1', [{ role: 'assistant', text: 'restored', thoughts: 'thinking', toolCalls: [] }])
    store.setHermesCurrentSession('session-1', 'acp-1')
    store.setHermesSessions('session-1', [{
      id: 'acp-1',
      title: null,
      source: 'discord',
      model: null,
      startedAt: 1,
      endedAt: null,
      messageCount: 2,
      archived: false,
    }])

    expect(useWorkspaceStore.getState().hermesTranscript['session-1']).toEqual([{ role: 'assistant', text: 'restored', thoughts: 'thinking', toolCalls: [] }])
    expect(useWorkspaceStore.getState().hermesCurrentSession['session-1']).toBe('acp-1')
    expect(useWorkspaceStore.getState().hermesSessions['session-1']).toHaveLength(1)
  })

  test('preserves Hermes assistant event order inside a turn', () => {
    const store = useWorkspaceStore.getState()

    store.appendHermesText('session-1', 'message', 'before')
    store.addHermesToolCall('session-1', { id: 'tool-1', title: 'Read file', toolKind: 'read', status: 'running' })
    store.appendHermesText('session-1', 'message', 'after')
    store.appendHermesText('session-1', 'thought', 'thinking')

    expect(useWorkspaceStore.getState().hermesTranscript['session-1'][0].parts).toEqual([
      { kind: 'message', text: 'before' },
      { kind: 'toolCall', toolCallId: 'tool-1' },
      { kind: 'message', text: 'after' },
      { kind: 'thought', text: 'thinking' },
    ])
  })

  test('pane completion highlights the focused active agent pane until input clears it', () => {
    vi.stubGlobal('document', { hasFocus: () => true })
    useWorkspaceStore.setState({
      activePaneId: 'pane-test',
      panes: { 'pane-test': spawnedPane },
      paneCompletionHighlights: {},
    })

    useWorkspaceStore.getState().markPaneResponseComplete('pane-test')

    expect(useWorkspaceStore.getState().paneCompletionHighlights['pane-test']).toMatchObject({ source: 'agent-response' })

    useWorkspaceStore.getState().clearPaneCompletionHighlight('pane-test')
    expect(useWorkspaceStore.getState().paneCompletionHighlights['pane-test']).toBeUndefined()
  })

  test('pane completion highlights the active agent pane while the app is unfocused', () => {
    useWorkspaceStore.setState({
      activePaneId: 'pane-test',
      panes: { 'pane-test': spawnedPane },
      paneCompletionHighlights: {},
    })

    useWorkspaceStore.getState().markPaneResponseComplete('pane-test')

    expect(useWorkspaceStore.getState().paneCompletionHighlights['pane-test']).toMatchObject({ source: 'agent-response' })
  })

  test('pane completion highlights an inactive agent pane until it is activated', () => {
    vi.stubGlobal('document', { hasFocus: () => true })
    useWorkspaceStore.setState({
      activePaneId: undefined,
      panes: { 'pane-test': spawnedPane },
      paneCompletionHighlights: {},
    })

    useWorkspaceStore.getState().markPaneResponseComplete('pane-test')

    expect(useWorkspaceStore.getState().paneCompletionHighlights['pane-test']).toMatchObject({ source: 'agent-response' })

    useWorkspaceStore.getState().setActivePaneId('pane-test')
    expect(useWorkspaceStore.getState().paneCompletionHighlights['pane-test']).toBeUndefined()
  })

  test('pane completion does not highlight a non-agent pane', () => {
    useWorkspaceStore.setState({
      activePaneId: 'pane-shell',
      panes: { 'pane-shell': nonAgentPane },
      paneCompletionHighlights: {},
    })

    useWorkspaceStore.getState().markPaneResponseComplete('pane-shell')

    expect(useWorkspaceStore.getState().paneCompletionHighlights['pane-shell']).toBeUndefined()
  })

  test('deleteSession clears Hermes session browser state', async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'delete_session') return null
      if (command === 'list_sessions') return [secondSession]
      if (command === 'attach_session') return { layoutJson: null, panes: [spawnedPane] }
      return null
    })
    useWorkspaceStore.setState({
      sessions: [createdSession, secondSession],
      hermesCurrentSession: { [createdSession.id]: 'acp-1' },
      hermesSessions: { [createdSession.id]: [{ id: 'acp-1', title: null, source: 'discord', model: null, startedAt: 1, endedAt: null, messageCount: 1, archived: false }] },
      hermesTranscript: { [createdSession.id]: [{ role: 'user', text: 'hello', thoughts: '', toolCalls: [] }] },
    })

    await useWorkspaceStore.getState().deleteSession(createdSession.id)

    expect(useWorkspaceStore.getState().hermesCurrentSession[createdSession.id]).toBeUndefined()
    expect(useWorkspaceStore.getState().hermesSessions[createdSession.id]).toBeUndefined()
    expect(useWorkspaceStore.getState().hermesTranscript[createdSession.id]).toBeUndefined()
  })

  test('setPaneRole preserves keybindings identity while updating pane roles', () => {
    useWorkspaceStore.setState({
      settings: normalizeSettings({
        ...defaultSettings,
        keybindings: { ...defaultSettings.keybindings, splitRight: 'Ctrl+Alt+Right' },
        paneRoles: {},
      }),
    })
    const keybindings = useWorkspaceStore.getState().settings.keybindings

    useWorkspaceStore.getState().setPaneRole('pane-test', 'Reviewer')

    expect(useWorkspaceStore.getState().settings.paneRoles).toEqual({ 'pane-test': 'Reviewer' })
    expect(useWorkspaceStore.getState().settings.keybindings).toBe(keybindings)
  })

  test('deleteSession prunes pane keyed maps for the deleted active session', async () => {
    const survivorPane: PaneMeta = {
      ...spawnedPane,
      id: 'pane-survivor',
      config: { ...spawnedPane.config, paneId: 'pane-survivor', title: 'Survivor' },
    }
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'delete_session') return null
      if (command === 'list_sessions') return [secondSession]
      if (command === 'attach_session') return { layoutJson: null, panes: [survivorPane] }
      return null
    })
    useWorkspaceStore.setState({
      sessions: [createdSession, secondSession],
      activeSessionId: createdSession.id,
      panes: { [spawnedPane.id]: spawnedPane, [nonAgentPane.id]: nonAgentPane },
      manualPaneTitles: { [spawnedPane.id]: true, [nonAgentPane.id]: true, [survivorPane.id]: true },
      capturesByPane: { [spawnedPane.id]: ['deleted.png'], [nonAgentPane.id]: ['deleted-shell.png'], [survivorPane.id]: ['keep.png'] },
      settings: normalizeSettings({
        ...defaultSettings,
        paneRoles: { [spawnedPane.id]: 'Deleted agent', [nonAgentPane.id]: 'Deleted shell', [survivorPane.id]: 'Keep' },
      }),
    })

    await useWorkspaceStore.getState().deleteSession(createdSession.id)

    expect(useWorkspaceStore.getState().manualPaneTitles).toEqual({ [survivorPane.id]: true })
    expect(useWorkspaceStore.getState().capturesByPane).toEqual({ [survivorPane.id]: ['keep.png'] })
    expect(useWorkspaceStore.getState().settings.paneRoles).toEqual({ [survivorPane.id]: 'Keep' })
  })

  test('queues Hermes prompts FIFO and drains once', () => {
    const store = useWorkspaceStore.getState()

    store.enqueueHermesPrompt('session-1', 'first')
    store.enqueueHermesPrompt('session-1', 'second')

    expect(useWorkspaceStore.getState().takeHermesPrompt('session-1')).toBe('first')
    expect(useWorkspaceStore.getState().takeHermesPrompt('session-1')).toBe('second')
    expect(useWorkspaceStore.getState().takeHermesPrompt('session-1')).toBeUndefined()
  })
})
